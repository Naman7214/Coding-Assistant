import asyncio
import time
from datetime import datetime
from typing import Any, Dict

import httpx
from fastapi import Depends, HTTPException, status
from pinecone import Pinecone

from system.backend.app.config.settings import settings
from system.backend.app.models.domain.error import Error
from system.backend.app.repositories.error_repo import ErrorRepo
from system.backend.app.utils.logging_util import loggers


class PineconeService:
    def __init__(self, error_repo: ErrorRepo = Depends(ErrorRepo)):
        self.pinecone_api_key = settings.PINECONE_API_KEY
        self.api_version = settings.PINECONE_API_VERSION
        self.index_url = settings.PINECONE_CREATE_INDEX_URL
        self.dense_embed_url = settings.PINECONE_EMBED_URL
        self.upsert_url = settings.PINECONE_UPSERT_URL
        self.query_url = settings.PINECONE_QUERY_URL
        self.list_index_url = settings.PINECONE_LIST_INDEXES_URL
        self.semaphore = asyncio.Semaphore(10)
        self.pc = Pinecone(api_key=settings.PINECONE_API_KEY)
        self.error_repo = error_repo
        self.timeout = httpx.Timeout(
            connect=60.0,
            read=120.0,
            write=120.0,
            pool=60.0,
        )

    async def list_pinecone_indexes(self):
        url = self.list_index_url

        headers = {
            "Api-Key": self.pinecone_api_key,
            "X-Pinecone-API-Version": self.api_version,
        }

        try:
            async with httpx.AsyncClient(
                verify=False, timeout=self.timeout
            ) as client:
                response = await client.get(url, headers=headers)
                response.raise_for_status()
                return response.json()

        except httpx.HTTPStatusError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error in listing pinecone indexes HTTPStatusError : {e.response.text} - {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Error in listing pinecone indexes HTTPStatusError: {e.response.text} - {str(e)}",
            )
        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error in pinecone list indexes: {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error in pinecone list indexes: {str(e)}",
            )

    async def create_index(
        self, index_name: str, dimension: int, metric: str
    ) -> Dict[str, Any]:
        print(
            f"Creating index {index_name} with dimension {dimension} and metric {metric}"
        )
        if self.pc.has_index(index_name) == False:
            index_data = {
                "name": index_name,
                "dimension": dimension,
                "metric": metric,
                "spec": {"serverless": {"cloud": "aws", "region": "us-east-1"}},
            }

            headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Api-Key": self.pinecone_api_key,
                "X-Pinecone-API-Version": self.api_version,
            }

            try:
                async with httpx.AsyncClient(
                    verify=False, timeout=self.timeout
                ) as client:
                    response = await client.post(
                        self.index_url, headers=headers, json=index_data
                    )
                    response.raise_for_status()

                    retry_count = 0
                    max_retries = 30
                    while retry_count < max_retries:
                        index_status = (
                            self.pc.describe_index(index_name)
                            .get("status")
                            .get("state")
                        )
                        loggers["main"].info(f"Index status: {index_status}")

                        if index_status == "Ready":
                            loggers["main"].info(f"Index {index_name} is ready")
                            break

                        retry_count += 1
                        time.sleep(2)

                    if retry_count > max_retries:
                        raise HTTPException(
                            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                            detail="Index creation timed out",
                        )

                    loggers["main"].info("Index Created")
                    return response.json()

            except httpx.HTTPStatusError as e:
                await self.error_repo.insert_error(
                    Error(
                        tool_name="code_base_search",
                        error_message=f"Error creating index HTTPStatusError: {e.response.text} - {str(e)}",
                    )
                )

                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Error creating index HTTPStatusError: {e.response.text} - {str(e)}",
                )
            except Exception as e:
                await self.error_repo.insert_error(
                    Error(
                        tool_name="code_base_search",
                        error_message=f"Error creating index: {str(e)}",
                    )
                )
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Error creating index: {str(e)}",
                )

        else:
            loggers["main"].info("index already created")
            return {"host": self.pc.describe_index(index_name).get("host")}

    async def upsert_format(
        self, chunks: list, vector_embeddings: list  # , sparse_embeddings: list
    ):
        results = []
        for i in range(len(chunks)):
            # Only include specific metadata fields as per requirements
            metadata = {
                "obfuscated_path": chunks[i].get("obfuscated_path"),
                "start_line": chunks[i].get("start_line"),
                "end_line": chunks[i].get("end_line"),
                "language": chunks[i].get("language"),
                "chunk_type": chunks[i].get("chunk_type"),
                "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }

            result = {
                "id": chunks[i].get("chunk_hash"),
                "values": vector_embeddings[i],
                "metadata": metadata,
                # "sparse_values": {
                #     "indices": sparse_embeddings[i]["indices"],
                #     "values": sparse_embeddings[i]["values"],
                # },
            }
            results.append(result)
        return results

    async def upsert_vectors(self, index_host, input, namespace):
        headers = {
            "Api-Key": self.pinecone_api_key,
            "Content-Type": "application/json",
            "X-Pinecone-API-Version": self.api_version,
        }

        url = self.upsert_url.format(index_host)

        payload = {"vectors": input, "namespace": namespace}
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout, verify=False
            ) as client:
                response = await client.post(
                    url=url, headers=headers, json=payload
                )
                response.raise_for_status()
                return response.json()

        except httpx.HTTPStatusError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error in upsert vectors http status error : {str(e)} - {e.response.text}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Error in upsert vectors http status error : {str(e)} - {e.response.text}",
            )

        except httpx.HTTPError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error in upsert vectors http error : {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Error in upsert vectors http error : {str(e)}",
            )

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error in upsert vectors: {str(e)}",
                )
            )

            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
            )

    def hybrid_scale(self, dense, sparse, alpha: float):

        if alpha < 0 or alpha > 1:
            raise ValueError("Alpha must be between 0 and 1")
        # scale sparse and dense vectors to create hybrid search vecs
        hsparse = {
            "indices": sparse["indices"],
            "values": [v * (1 - alpha) for v in sparse["values"]],
        }
        hdense = [v * alpha for v in dense]
        return hdense, hsparse

    async def pinecone_hybrid_query(
        self,
        index_host,
        namespace,
        top_k,
        alpha: int,
        query_vector_embeds: list,
        query_sparse_embeds: dict,
        include_metadata: bool,
        filter_dict: dict = None,
    ):

        if query_vector_embeds is None or query_sparse_embeds is None:
            time.sleep(2)

        headers = {
            "Api-Key": self.pinecone_api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "X-Pinecone-API-Version": self.api_version,
        }

        hdense, hsparse = self.hybrid_scale(
            query_vector_embeds, query_sparse_embeds, alpha
        )

        payload = {
            "includeValues": False,
            "includeMetadata": include_metadata,
            "vector": hdense,
            "sparseVector": {
                "indices": hsparse.get("indices"),
                "values": hsparse.get("values"),
            },
            "topK": top_k,
            "namespace": namespace,
        }

        if filter_dict:
            payload["filter"] = filter_dict

        url = self.query_url.format(index_host)
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout, verify=False
            ) as client:
                response = await client.post(url, headers=headers, json=payload)
                loggers["pinecone"].info(
                    f"pinecone hybrid query read units: {response.json()['usage']}"
                )
                return response.json()

        except httpx.HTTPStatusError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"HTTP status error in hybrid query: {e.response.text} - {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"HTTP status error in hybrid query: {e.response.text} - {str(e)}",
            )

        except httpx.HTTPError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"HTTP error in hybrid query:  {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"HTTP error in hybrid query: {str(e)}",
            )

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error performing hybrid query: {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
            )

    async def pinecone_query(
        self,
        index_host: str,
        top_k: int,
        vector: list,
        include_metadata: bool,
        filter_dict: dict | None = None,
        namespace: str = "default",
    ):

        headers = {
            "Api-Key": self.pinecone_api_key,
            "Content-Type": "application/json",
            "X-Pinecone-API-Version": self.api_version,
        }

        payload = {
            "namespace": namespace,
            "vector": vector,
            "topK": top_k,
            "includeValues": False,
            "includeMetadata": include_metadata,
        }

        if filter_dict:
            payload["filter"] = filter_dict

        url = self.query_url.format(index_host)

        try:
            async with httpx.AsyncClient(
                verify=False, timeout=self.timeout
            ) as client:
                response = await client.post(url, headers=headers, json=payload)
                loggers["pinecone"].info(
                    f"pinecone Normal query read units: {response.json()['usage']}"
                )
                return response.json()

        except httpx.HTTPStatusError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"HTTP status error in pinecone query: {e.response.text} - {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"HTTP status error in pinecone query: {e.response.text} - {str(e)}",
            )

        except httpx.RequestError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Request error in pinecone query: {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Request error in pinecone query: {str(e)}",
            )

        except httpx.HTTPError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"HTTP error in pinecone query: {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"HTTP error in pinecone query: {str(e)}",
            )

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error in pinecone query : {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error in pinecone query : {str(e)}",
            )

    async def get_index_details(self, index_name: str):
        url = f"https://api.pinecone.io/indexes/{index_name}"

        headers = {
            "Api-Key": self.pinecone_api_key,
            "X-Pinecone-API-Version": self.api_version,
        }

        try:
            async with httpx.AsyncClient(
                verify=False, timeout=self.timeout
            ) as client:
                response = await client.get(url, headers=headers)
                response.raise_for_status()
                index_details = response.json()
                return index_details

        except httpx.HTTPStatusError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error getting index details HTTPStatusError: {e.response.text} - {str(e)}",
                )
            )
            raise HTTPException(
                status_code=e.response.status_code,
                detail=f"Error getting index details: {e.response.text}",
            )
        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error retrieving index details: {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error retrieving index details: {str(e)}",
            )

    async def get_index_host(self, index_name: str) -> str:
        try:
            index_details = await self.get_index_details(index_name)
            if "host" not in index_details:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Host not found in index details for {index_name}",
                )
            return index_details["host"]
        except HTTPException:
            raise
        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="code_base_search",
                    error_message=f"Error extracting host from index details: {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error extracting host from index details: {str(e)}",
            )

    async def delete_vectors(
        self, index_host: str, vector_ids: list, namespace: str = "default"
    ) -> Dict[str, Any]:
        """Delete vectors from Pinecone index by their IDs"""
        headers = {
            "Api-Key": self.pinecone_api_key,
            "Content-Type": "application/json",
            "X-Pinecone-API-Version": self.api_version,
        }

        # Construct the delete URL (assuming it follows pattern similar to other operations)
        delete_url = f"https://{index_host}/vectors/delete"

        payload = {"ids": vector_ids, "namespace": namespace}

        try:
            async with httpx.AsyncClient(
                verify=False, timeout=self.timeout
            ) as client:
                response = await client.post(
                    url=delete_url, headers=headers, json=payload
                )
                response.raise_for_status()

                # Pinecone delete doesn't return much, just success
                loggers["main"].info(
                    f"Successfully deleted {len(vector_ids)} vectors from namespace '{namespace}'"
                )

                return {"deleted": len(vector_ids)}

        except httpx.HTTPStatusError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="pinecone_service",
                    error_message=f"Error deleting vectors http status error: {str(e)} - {e.response.text}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Error deleting vectors http status error: {str(e)} - {e.response.text}",
            )

        except httpx.HTTPError as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="pinecone_service",
                    error_message=f"Error deleting vectors http error: {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Error deleting vectors http error: {str(e)}",
            )

        except Exception as e:
            await self.error_repo.insert_error(
                Error(
                    tool_name="pinecone_service",
                    error_message=f"Error deleting vectors: {str(e)}",
                )
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e)
            )
